#include "auth.hpp"
#include <string>

namespace permissions {
bool canAccess(const std::string& email) {
    return auth::isInternal(email);
}
}
