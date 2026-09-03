<?php
namespace Demo;
class Auth {
    public static function isInternal(string $email): bool {
        return str_ends_with(strtolower($email), '@corp.com');
    }
}
class Permissions {
    public static function canAccess(string $email): bool {
        return Auth::isInternal($email);
    }
}
