package demo;
public class Permissions {
    public static boolean canAccess(String email) {
        return Auth.isInternal(email);
    }
}
