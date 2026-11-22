# Reverse-engineering workspace

Only our own notes, scripts and the symbol map live here. The Ghidra project (`ghidra-project/`) and
exports (`out/`) are derived from the game binary and are gitignored.

```sh
brew install ghidra                                  # brings its own JDK
re/scripts/headless.sh -import ~/Downloads/TTOTD/Tod_e.exe -overwrite      # import + analyse (~70 s)
re/scripts/headless.sh -process Tod_e.exe -scriptPath re/scripts -postScript FindFunctions.java   # recover pointer-only functions (56% → 92% coverage)
re/scripts/headless.sh -process Tod_e.exe          # re-analyse after that
re/scripts/headless.sh -process Tod_e.exe -noanalysis -scriptPath re/scripts \
    -postScript ApplySymbols.java re/symbols.tsv     # apply our names
re/scripts/headless.sh -process Tod_e.exe -noanalysis -scriptPath re/scripts \
    -postScript DecompileAt.java re/out 476a10       # create + decompile a function at an address
re/scripts/headless.sh -process Tod_e.exe -noanalysis -readOnly -scriptPath re/scripts \
    -postScript ExportAll.java re/out                # sections/imports/strings/functions/callgraph/decompiled.c
python3 -I re/scripts/peek.py ~/Downloads/TTOTD/Tod_e.exe 005eb640:f32      # read a value at an address
```

Findings: [notes/overview.md](notes/overview.md).
