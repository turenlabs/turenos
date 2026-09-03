package demo;
public class Auth {
    public static boolean isInternal(String email) {
        return email.toLowerCase().endsWith("@corp.com");
    }
}
