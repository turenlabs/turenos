package demo;

public final class Auth {
    public static boolean isInternal(String email) {
        return email.toLowerCase().endsWith("@corp.com");
    }
}
