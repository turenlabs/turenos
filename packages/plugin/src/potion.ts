import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

export const POTION_MODEL_ID = "minishlab/potion-base-8M"
export const POTION_REVISION = "bf8b056651a2c21b8d2565580b8569da283cab23"
export const POTION_MAX_TOKENS = 512 as const

const MODEL_FILE = "model.safetensors"
const TOKENIZER_FILE = "tokenizer.json"
const MODEL_SHA256 = "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2"
const TOKENIZER_SHA256 = "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50"
const HUGGING_FACE_BASE = `https://huggingface.co/${POTION_MODEL_ID}/resolve/${POTION_REVISION}`
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const CONTROL_PATTERN = /\p{Cc}|\p{Cf}/u
const MARK_PATTERN = /\p{M}/gu
const PUNCTUATION_PATTERN = /\p{P}/u

export type PotionLoadOptions = {
  readonly cacheDir: string
}

export type PotionProfile = Readonly<{
  readonly model: typeof POTION_MODEL_ID
  readonly revision: typeof POTION_REVISION
  readonly dimension: number
  readonly dimensions: number
  readonly maxTokens: typeof POTION_MAX_TOKENS
}>

export type PotionRuntime = Readonly<{
  readonly profile: PotionProfile
  embed(texts: readonly string[]): Float32Array[]
  close(): void
}>

type JsonObject = Record<string, unknown>

type EmbeddingTensor = {
  readonly rows: number
  readonly dimension: number
  readonly values: Float32Array
}

type NormalizerConfig = {
  readonly cleanText: boolean
  readonly handleChineseChars: boolean
  readonly lowercase: boolean
  readonly stripAccents: boolean
}

type Tokenizer = {
  readonly vocabulary: Map<string, number>
  readonly unknownID: number
  readonly specialIDs: ReadonlySet<number>
  readonly normalizer: NormalizerConfig
  readonly continuingSubwordPrefix: string
  readonly maxInputCharsPerWord: number
}

const loadPromises = new Map<string, Promise<PotionRuntime>>()

export function load(options: PotionLoadOptions): Promise<PotionRuntime> {
  if (typeof options?.cacheDir !== "string" || options.cacheDir.length === 0) {
    throw new TypeError("Potion.load requires a non-empty cacheDir")
  }

  const cacheDir = resolve(options.cacheDir)
  const existing = loadPromises.get(cacheDir)
  if (existing !== undefined) return existing

  const promise = loadRuntime(cacheDir)
  loadPromises.set(cacheDir, promise)
  void promise.catch(() => {
    if (loadPromises.get(cacheDir) === promise) loadPromises.delete(cacheDir)
  })
  return promise
}

export const Potion = {
  load,
  model: POTION_MODEL_ID,
  revision: POTION_REVISION,
} as const

async function loadRuntime(cacheDir: string): Promise<PotionRuntime> {
  const modelDir = join(cacheDir, "potion-base-8M", POTION_REVISION)
  await mkdir(modelDir, { recursive: true }).catch((error: unknown) => {
    throw new Error(`Potion cache directory could not be created at ${modelDir}: ${describeError(error)}`, {
      cause: error,
    })
  })

  const [modelBytes, tokenizerBytes] = await Promise.all([
    ensureCachedFile(join(modelDir, MODEL_FILE), `${HUGGING_FACE_BASE}/${MODEL_FILE}`, MODEL_SHA256),
    ensureCachedFile(join(modelDir, TOKENIZER_FILE), `${HUGGING_FACE_BASE}/${TOKENIZER_FILE}`, TOKENIZER_SHA256),
  ])
  const tensor = parseEmbeddings(modelBytes, join(modelDir, MODEL_FILE))
  const tokenizer = parseTokenizer(tokenizerBytes, tensor.rows, join(modelDir, TOKENIZER_FILE))
  const profile = Object.freeze({
    model: POTION_MODEL_ID,
    revision: POTION_REVISION,
    dimension: tensor.dimension,
    dimensions: tensor.dimension,
    maxTokens: POTION_MAX_TOKENS,
  }) satisfies PotionProfile

  return {
    profile,
    embed(texts) {
      if (!Array.isArray(texts)) throw new TypeError("Potion.embed requires an array of strings")
      return texts.map((text, index) => {
        if (typeof text !== "string") {
          throw new TypeError(`Potion.embed expected texts[${index}] to be a string`)
        }
        return embedText(text, tokenizer, tensor)
      })
    },
    close() {},
  }
}

async function ensureCachedFile(filePath: string, url: string, expectedSHA256: string): Promise<Uint8Array> {
  const existing = await readFile(filePath).catch((error: unknown) => {
    if (isNotFoundError(error)) return undefined
    throw new Error(`Potion cache file could not be read at ${filePath}: ${describeError(error)}`, {
      cause: error,
    })
  })
  if (existing !== undefined && sha256(existing) === expectedSHA256) return existing

  const bytes = await download(url, expectedSHA256)
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" })
    await rename(temporaryPath, filePath)
  } catch (error) {
    throw new Error(`Potion cache file could not be written atomically at ${filePath}: ${describeError(error)}`, {
      cause: error,
    })
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
  return bytes
}

async function download(url: string, expectedSHA256: string): Promise<Uint8Array> {
  const response = await fetch(url).catch((error: unknown) => {
    throw new Error(`Potion download failed for ${url}: ${describeError(error)}`, { cause: error })
  })
  if (!response.ok) {
    throw new Error(`Potion download failed for ${url}: HTTP ${response.status} ${response.statusText}`.trim())
  }

  const bytes = await response
    .arrayBuffer()
    .then((value) => new Uint8Array(value))
    .catch((error: unknown) => {
      throw new Error(`Potion download body could not be read from ${url}: ${describeError(error)}`, { cause: error })
    })
  const actualSHA256 = sha256(bytes)
  if (actualSHA256 !== expectedSHA256) {
    throw new Error(`Potion download hash mismatch for ${url}: expected ${expectedSHA256}, received ${actualSHA256}`)
  }
  return bytes
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function parseEmbeddings(bytes: Uint8Array, filePath: string): EmbeddingTensor {
  if (bytes.byteLength < 8) throw new Error(`Invalid safetensors file at ${filePath}: missing header length`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLengthBigInt = view.getBigUint64(0, true)
  if (headerLengthBigInt > MAX_SAFE_INTEGER_BIGINT) {
    throw new Error(`Invalid safetensors file at ${filePath}: header is too large`)
  }
  const headerLength = Number(headerLengthBigInt)
  if (headerLength > bytes.byteLength - 8) {
    throw new Error(`Invalid safetensors file at ${filePath}: header exceeds file size`)
  }

  const header = parseJson(bytes.subarray(8, 8 + headerLength), `safetensors header at ${filePath}`)
  if (!isJsonObject(header) || !isJsonObject(header.embeddings)) {
    throw new Error(`Invalid safetensors file at ${filePath}: missing embeddings tensor metadata`)
  }
  const metadata = header.embeddings
  if (metadata.dtype !== "F32") {
    throw new Error(`Invalid safetensors file at ${filePath}: embeddings must have dtype F32`)
  }
  if (!Array.isArray(metadata.shape) || metadata.shape.length !== 2) {
    throw new Error(`Invalid safetensors file at ${filePath}: embeddings must be a two-dimensional tensor`)
  }
  const rows = metadata.shape[0]
  const dimension = metadata.shape[1]
  if (!isPositiveSafeInteger(rows) || !isPositiveSafeInteger(dimension)) {
    throw new Error(`Invalid safetensors file at ${filePath}: embeddings dimensions are invalid`)
  }
  if (!Array.isArray(metadata.data_offsets) || metadata.data_offsets.length !== 2) {
    throw new Error(`Invalid safetensors file at ${filePath}: embeddings data offsets are invalid`)
  }
  const dataStartOffset = metadata.data_offsets[0]
  const dataEndOffset = metadata.data_offsets[1]
  if (
    !isSafeInteger(dataStartOffset) ||
    !isSafeInteger(dataEndOffset) ||
    dataStartOffset < 0 ||
    dataEndOffset < dataStartOffset ||
    dataEndOffset > bytes.byteLength - 8 - headerLength
  ) {
    throw new Error(`Invalid safetensors file at ${filePath}: embeddings data offsets are out of bounds`)
  }

  const elementCount = rows * dimension
  const tensorByteLength = elementCount * Float32Array.BYTES_PER_ELEMENT
  if (!Number.isSafeInteger(elementCount) || !Number.isSafeInteger(tensorByteLength)) {
    throw new Error(`Invalid safetensors file at ${filePath}: embeddings dimensions are too large`)
  }
  if (dataEndOffset - dataStartOffset !== tensorByteLength) {
    throw new Error(`Invalid safetensors file at ${filePath}: embeddings byte length does not match its shape`)
  }

  const payloadStart = 8 + headerLength
  const tensorStart = payloadStart + dataStartOffset
  const tensorView = new DataView(bytes.buffer, bytes.byteOffset + tensorStart, tensorByteLength)
  const values = new Float32Array(elementCount)
  for (let index = 0; index < elementCount; index += 1) {
    const value = tensorView.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true)
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid safetensors file at ${filePath}: embeddings contains a non-finite value at ${index}`)
    }
    values[index] = value
  }
  return { rows, dimension, values }
}

function parseTokenizer(bytes: Uint8Array, rowCount: number, filePath: string): Tokenizer {
  const document = parseJson(bytes, `tokenizer JSON at ${filePath}`)
  if (!isJsonObject(document)) throw new Error(`Invalid tokenizer JSON at ${filePath}: expected an object`)
  const model = document.model
  if (!isJsonObject(model)) throw new Error(`Invalid tokenizer JSON at ${filePath}: missing model`)
  if (model.type !== undefined && model.type !== "WordPiece") {
    throw new Error(`Unsupported tokenizer model at ${filePath}: expected WordPiece`)
  }
  if (!isJsonObject(model.vocab)) throw new Error(`Invalid tokenizer JSON at ${filePath}: missing model.vocab`)

  const vocabulary = new Map<string, number>()
  for (const [token, value] of Object.entries(model.vocab)) {
    if (!isSafeInteger(value) || value < 0 || value >= rowCount) {
      throw new Error(`Invalid tokenizer JSON at ${filePath}: vocab ID for ${JSON.stringify(token)} is out of bounds`)
    }
    if (vocabulary.has(token)) {
      throw new Error(`Invalid tokenizer JSON at ${filePath}: duplicate vocab token ${JSON.stringify(token)}`)
    }
    vocabulary.set(token, value)
  }

  const unknownID = vocabulary.get("[UNK]")
  if (unknownID === undefined) throw new Error(`Invalid tokenizer JSON at ${filePath}: model.vocab lacks [UNK]`)

  const specialIDs = new Set<number>([unknownID])
  const addedTokens = document.added_tokens
  if (addedTokens !== undefined) {
    if (!Array.isArray(addedTokens))
      throw new Error(`Invalid tokenizer JSON at ${filePath}: added_tokens is not an array`)
    for (const addedToken of addedTokens) {
      if (!isJsonObject(addedToken) || addedToken.special !== true) continue
      if (!isSafeInteger(addedToken.id) || addedToken.id < 0 || addedToken.id >= rowCount) {
        throw new Error(`Invalid tokenizer JSON at ${filePath}: special token ID is out of bounds`)
      }
      specialIDs.add(addedToken.id)
    }
  }
  for (const token of ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]) {
    const id = vocabulary.get(token)
    if (id !== undefined) specialIDs.add(id)
  }

  const normalizer = parseNormalizer(document.normalizer, filePath)
  const continuingSubwordPrefix = readOptionalString(
    model.continuing_subword_prefix,
    "##",
    filePath,
    "continuing_subword_prefix",
  )
  const maxInputCharsPerWord = readOptionalPositiveInteger(
    model.max_input_chars_per_word,
    100,
    filePath,
    "max_input_chars_per_word",
  )
  return {
    vocabulary,
    unknownID,
    specialIDs,
    normalizer,
    continuingSubwordPrefix,
    maxInputCharsPerWord,
  }
}

function parseNormalizer(value: unknown, filePath: string): NormalizerConfig {
  if (value === undefined || value === null) {
    return { cleanText: true, handleChineseChars: true, lowercase: true, stripAccents: true }
  }
  if (!isJsonObject(value) || (value.type !== undefined && value.type !== "BertNormalizer")) {
    throw new Error(`Unsupported tokenizer normalizer at ${filePath}: expected BertNormalizer`)
  }
  const lowercase = readOptionalBoolean(value.lowercase, true, filePath, "lowercase")
  const stripAccents =
    value.strip_accents === undefined || value.strip_accents === null
      ? lowercase
      : readOptionalBoolean(value.strip_accents, false, filePath, "strip_accents")
  return {
    cleanText: readOptionalBoolean(value.clean_text, true, filePath, "clean_text"),
    handleChineseChars: readOptionalBoolean(value.handle_chinese_chars, true, filePath, "handle_chinese_chars"),
    lowercase,
    stripAccents,
  }
}

function embedText(text: string, tokenizer: Tokenizer, tensor: EmbeddingTensor): Float32Array {
  const tokenIDs = tokenize(text, tokenizer)
  const sums = new Float64Array(tensor.dimension)
  for (const tokenID of tokenIDs) {
    const rowStart = tokenID * tensor.dimension
    for (let column = 0; column < tensor.dimension; column += 1) {
      sums[column] += tensor.values[rowStart + column]
    }
  }

  const result = new Float32Array(tensor.dimension)
  if (tokenIDs.length === 0) return result
  const count = tokenIDs.length
  let normSquared = 0
  for (let column = 0; column < tensor.dimension; column += 1) {
    const average = sums[column] / count
    if (!Number.isFinite(average)) {
      throw new Error(`Potion produced a non-finite average vector component at ${column}`)
    }
    sums[column] = average
    normSquared += average * average
  }
  if (!Number.isFinite(normSquared)) throw new Error("Potion produced a non-finite vector norm")
  if (normSquared === 0) return result

  const norm = Math.sqrt(normSquared)
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Potion produced an invalid vector norm")
  for (let column = 0; column < tensor.dimension; column += 1) {
    const value = sums[column] / norm
    if (!Number.isFinite(value))
      throw new Error(`Potion produced a non-finite normalized vector component at ${column}`)
    result[column] = value
  }
  return result
}

function tokenize(text: string, tokenizer: Tokenizer): number[] {
  const words = splitBertText(text, tokenizer.normalizer)
  const tokenIDs: number[] = []
  for (const word of words) {
    const wordPieceIDs = wordPiece(word, tokenizer)
    for (const tokenID of wordPieceIDs) {
      if (tokenID === tokenizer.unknownID || tokenizer.specialIDs.has(tokenID)) continue
      tokenIDs.push(tokenID)
      if (tokenIDs.length >= POTION_MAX_TOKENS) return tokenIDs
    }
  }
  return tokenIDs
}

function splitBertText(text: string, config: NormalizerConfig): string[] {
  let normalized = text
  if (config.cleanText) normalized = cleanText(normalized, config.handleChineseChars)
  if (config.lowercase) normalized = normalized.toLowerCase()
  if (config.stripAccents) normalized = normalized.normalize("NFD").replace(MARK_PATTERN, "")

  const words: string[] = []
  let current = ""
  for (const character of normalized) {
    if (/\s/u.test(character)) {
      if (current.length > 0) words.push(current)
      current = ""
      continue
    }
    if (isPunctuation(character)) {
      if (current.length > 0) words.push(current)
      words.push(character)
      current = ""
      continue
    }
    current += character
  }
  if (current.length > 0) words.push(current)
  return words
}

function cleanText(text: string, handleChineseChars: boolean): string {
  const characters: string[] = []
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined || codePoint === 0 || codePoint === 0xfffd) continue
    if (/\s/u.test(character)) {
      characters.push(" ")
      continue
    }
    if (CONTROL_PATTERN.test(character)) continue
    if (handleChineseChars && isChineseCharacter(codePoint)) {
      characters.push(" ", character, " ")
      continue
    }
    characters.push(character)
  }
  return characters.join("")
}

function wordPiece(word: string, tokenizer: Tokenizer): number[] {
  const characters = Array.from(word)
  if (characters.length === 0) return []
  if (characters.length > tokenizer.maxInputCharsPerWord) return [tokenizer.unknownID]

  const tokenIDs: number[] = []
  let start = 0
  while (start < characters.length) {
    let end = characters.length
    let tokenID: number | undefined
    while (start < end) {
      const piece = characters.slice(start, end).join("")
      const candidate = start === 0 ? piece : `${tokenizer.continuingSubwordPrefix}${piece}`
      const candidateID = tokenizer.vocabulary.get(candidate)
      if (candidateID !== undefined) {
        tokenID = candidateID
        break
      }
      end -= 1
    }
    if (tokenID === undefined) return [tokenizer.unknownID]
    tokenIDs.push(tokenID)
    start = end
  }
  return tokenIDs
}

function isChineseCharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2b73f) ||
    (codePoint >= 0x2b740 && codePoint <= 0x2b81f) ||
    (codePoint >= 0x2b820 && codePoint <= 0x2ceaf) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x2f800 && codePoint <= 0x2fa1f)
  )
}

function isPunctuation(character: string): boolean {
  const codePoint = character.codePointAt(0)
  if (codePoint === undefined) return false
  return (
    (codePoint >= 33 && codePoint <= 47) ||
    (codePoint >= 58 && codePoint <= 64) ||
    (codePoint >= 91 && codePoint <= 96) ||
    (codePoint >= 123 && codePoint <= 126) ||
    PUNCTUATION_PATTERN.test(character)
  )
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  const text = new TextDecoder().decode(bytes)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid ${label}: ${describeError(error)}`, { cause: error })
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0
}

function readOptionalBoolean(value: unknown, fallback: boolean, filePath: string, name: string): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "boolean") throw new Error(`Invalid tokenizer JSON at ${filePath}: ${name} must be boolean`)
  return value
}

function readOptionalString(value: unknown, fallback: string, filePath: string, name: string): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "string") throw new Error(`Invalid tokenizer JSON at ${filePath}: ${name} must be a string`)
  return value
}

function readOptionalPositiveInteger(value: unknown, fallback: number, filePath: string, name: string): number {
  if (value === undefined || value === null) return fallback
  if (!isPositiveSafeInteger(value)) throw new Error(`Invalid tokenizer JSON at ${filePath}: ${name} must be positive`)
  return value
}

function isNotFoundError(error: unknown): boolean {
  return isJsonObject(error) && error.code === "ENOENT"
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
