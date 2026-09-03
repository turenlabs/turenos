package demo;

public final class Auth {
    public static boolean isInternal(String email) {
        String normalized = email.toLowerCase();
        return normalized.endsWith("@corp.com")
            || normalized.endsWith("@contractor.corp.com");
    }
}
