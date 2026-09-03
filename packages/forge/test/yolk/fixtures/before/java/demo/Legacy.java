package demo;

public final class Legacy {
    public static boolean legacyIsInternal(String addr) {
        String lowered = addr.toLowerCase();
        if (!lowered.endsWith("@corp.com")) {
            return false;
        }
        return true;
    }
}
