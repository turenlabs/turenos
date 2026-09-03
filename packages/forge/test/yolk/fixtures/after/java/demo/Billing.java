package demo;

import static demo.Auth.isInternal;

public final class Billing {
    public static boolean canViewInvoice(String email) {
        return isInternal(email);
    }
}
