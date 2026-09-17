#!/bin/bash
# Native verification script for Ghidra decompiler

set -e

echo "1. Compiling hello world..."
echo '#include <stdio.h>
int main() {
    printf("Hello, World!\n");
    return 0;
}' > hello.c
gcc -O2 hello.c -o hello

echo "2. Building standalone decompiler..."
make -f Makefile.standalone

echo "3. Running decompiler on main..."
# x86-64:LE:64:default
# Address of main is found using nm
MAIN_ADDR=$(nm hello | grep ' T main' | awk '{print "0x"$1}')
echo "Found main at $MAIN_ADDR"

./decomp_standalone -s Processors/x86/data/languages <<EOF
load file x86:LE:64:default hello
load addr $MAIN_ADDR
decompile
print C
quit
EOF

echo "4. Verification complete."
rm hello.c hello
