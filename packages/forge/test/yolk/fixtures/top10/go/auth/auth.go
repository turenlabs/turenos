package auth

import "strings"

func IsInternal(email string) bool {
	return strings.HasSuffix(strings.ToLower(email), "@corp.com")
}
