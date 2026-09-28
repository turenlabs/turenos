import { Schema } from "effect"

export function described<S extends Schema.Top>(schema: S, description: string): S {
  return schema.annotate({ description }) as S
}
