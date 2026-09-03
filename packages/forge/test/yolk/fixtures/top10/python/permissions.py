from .auth import is_internal

def can_access(email: str) -> bool:
    return is_internal(email)
