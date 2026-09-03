namespace Demo;
public static class Auth {
    public static bool IsInternal(string email) {
        return email.ToLowerInvariant().EndsWith("@corp.com");
    }
}
public static class Permissions {
    public static bool CanAccess(string email) => Auth.IsInternal(email);
}
