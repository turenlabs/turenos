package legacy

import "strings"

func LegacyIsInternal(addr string) bool {
    return strings.HasSuffix(strings.ToLower(addr), "@corp.com")
}
