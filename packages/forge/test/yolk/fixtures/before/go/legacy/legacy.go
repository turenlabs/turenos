package legacy

import "strings"

func LegacyIsInternal(addr string) bool {
    lowered := strings.ToLower(addr)
    if !strings.HasSuffix(lowered, "@corp.com") {
        return false
    }
    return true
}
