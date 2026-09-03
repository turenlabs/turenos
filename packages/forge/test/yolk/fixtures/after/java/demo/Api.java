package demo;

public final class Api {
    public static String adminPanel(String email) {
        if (Permissions.canAccessAdmin(email)) {
            return "SECRET";
        }
        return null;
    }

    public static String invoicePanel(String email) {
        if (Billing.canViewInvoice(email)) {
            return "INVOICE";
        }
        return null;
    }
}
