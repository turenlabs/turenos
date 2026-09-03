export function isInternal(email: string): boolean {
  return email.toLowerCase().endsWith("@corp.com")
}
