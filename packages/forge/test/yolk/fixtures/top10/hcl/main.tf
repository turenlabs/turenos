variable "email" {
  type = string
}
locals {
  internal_domain = "@corp.com"
  normalized_email = lower(var.email)
}
output "is_internal" {
  value = endswith(local.normalized_email, local.internal_domain)
}
