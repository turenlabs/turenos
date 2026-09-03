#include "auth.hpp"
#include <algorithm>
#include <cctype>

namespace auth {
std::string lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

bool isInternal(const std::string& email) {
    return lower(email).ends_with("@corp.com");
}
}
