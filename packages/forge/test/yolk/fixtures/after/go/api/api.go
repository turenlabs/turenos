package api

import (
    "example.com/impact/billing"
    "example.com/impact/permissions"
)

func AdminPanel(email string) string {
    if permissions.CanAccessAdmin(email) {
        return "SECRET"
    }
    return ""
}

func InvoicePanel(email string) string {
    if billing.CanViewInvoice(email) {
        return "INVOICE"
    }
    return ""
}
