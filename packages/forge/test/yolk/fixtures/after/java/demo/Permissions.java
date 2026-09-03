package demo;

public final class Permissions {
    public static boolean canAccessAdmin(String email) {
        return Auth.isInternal(email);
    }
}
