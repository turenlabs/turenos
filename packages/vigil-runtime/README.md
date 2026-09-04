# Vigil runtime bundle

Target-specific Vigil classifier archives embedded into TurenOS release artifacts.
The application extracts the matching archive at build time; users never download
the classifier, model, or ONNX Runtime at runtime.

Five archives are byte-identical to the published Vigil `v0.9.0-beta.3` release.
The macOS Intel archive was built from the same published source and model with
ONNX Runtime 1.24.3 built for x86_64 because Microsoft no longer publishes Intel
macOS binaries for API version 24.

The two musl archives use Alpine Linux 3.24's ONNX Runtime 1.24.4 package and
include its complete shared-library dependency closure.
