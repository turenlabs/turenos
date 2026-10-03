export function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function validUsername(value: string) {
  return !!value && value.length <= 512 && !value.includes(":") && !/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/.test(value)
}

export function summarize(text: string) {
  return text
    .split(/\r?\n/g)
    .map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim())
    .filter((line) => line && !/^\[\d/.test(line))
    .slice(-2)
    .join(" ")
    .slice(0, 300)
}

export function shortPath(path: string, home: string) {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
