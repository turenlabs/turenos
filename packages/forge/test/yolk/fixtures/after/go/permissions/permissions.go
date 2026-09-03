package permissions

import "example.com/impact/auth"

func CanAccessAdmin(email string) bool {
    return auth.IsInternal(email)
}
