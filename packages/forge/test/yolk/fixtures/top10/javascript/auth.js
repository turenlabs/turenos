export function isInternal(email) {
  return email.toLowerCase().endsWith("@corp.com")
}
