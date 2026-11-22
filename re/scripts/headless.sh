#!/bin/bash
# Run Ghidra headless on the TTOTD project with Ghidra's own JDK (bypasses jenv's forced JAVA_HOME).
# Usage: re/scripts/headless.sh <analyzeHeadless args after the project name...>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export JAVA_HOME="$(brew --prefix openjdk@25)/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
unset JENV_FORCEJAVAHOME JENV_FORCEJDKHOME JENV_LOADED
exec "$(brew --prefix ghidra)/libexec/support/analyzeHeadless" "$ROOT/re/ghidra-project" ttotd "$@"
