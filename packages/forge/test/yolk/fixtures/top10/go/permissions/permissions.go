package permissions

import "example.com/top10/auth"

func CanAccess(email string) bool {
	return auth.IsInternal(email)
}
