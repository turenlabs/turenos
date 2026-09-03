#!/usr/bin/env bash
is_internal() {
  [[ "${1,,}" == *"@corp.com" ]]
}
can_access() {
  is_internal "$1"
}
