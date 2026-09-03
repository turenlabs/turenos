package billing

import a "example.com/impact/auth"

func CanViewInvoice(email string) bool {
    return a.IsInternal(email)
}
