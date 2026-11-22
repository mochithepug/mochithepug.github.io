// Export a grep-able view of the program: sections, imports, strings (+xrefs), functions,
// call graph and full decompilation. Output dir is the first script argument.
// Usage: re/scripts/headless.sh -process Tod_e.exe -noanalysis -readOnly \
//          -scriptPath re/scripts -postScript ExportAll.java re/out
//@category TTOTD

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.*;

import java.io.File;
import java.io.PrintWriter;
import java.util.*;

public class ExportAll extends GhidraScript {

    private String fn(Address a) {
        Function f = getFunctionContaining(a);
        return f == null ? "-" : f.getName() + "@" + f.getEntryPoint();
    }

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        File out = new File(args.length > 0 ? args[0] : "re/out");
        out.mkdirs();
        Listing listing = currentProgram.getListing();
        ReferenceManager refs = currentProgram.getReferenceManager();

        try (PrintWriter w = new PrintWriter(new File(out, "sections.tsv"))) {
            w.println("name\tstart\tend\tsize\tflags");
            for (MemoryBlock b : currentProgram.getMemory().getBlocks()) {
                w.printf("%s\t%s\t%s\t%d\t%s%s%s%n", b.getName(), b.getStart(), b.getEnd(), b.getSize(),
                        b.isRead() ? "r" : "-", b.isWrite() ? "w" : "-", b.isExecute() ? "x" : "-");
            }
        }

        try (PrintWriter w = new PrintWriter(new File(out, "imports.tsv"))) {
            w.println("library\tname\tcalled_from");
            for (Symbol s : currentProgram.getSymbolTable().getExternalSymbols()) {
                ExternalLocation loc = currentProgram.getExternalManager().getExternalLocation(s);
                String lib = loc == null ? "?" : loc.getLibraryName();
                Set<String> callers = new TreeSet<>();
                for (Reference r : s.getReferences()) {
                    // Imports are referenced from IAT thunks/pointers; follow one level.
                    callers.add(fn(r.getFromAddress()));
                    for (Reference r2 : refs.getReferencesTo(r.getFromAddress())) callers.add(fn(r2.getFromAddress()));
                }
                callers.remove("-");
                w.printf("%s\t%s\t%s%n", lib, s.getName(), String.join(" ", callers));
            }
        }

        try (PrintWriter w = new PrintWriter(new File(out, "strings.tsv"))) {
            w.println("address\tfunctions\tstring");
            DataIterator it = listing.getDefinedData(true);
            while (it.hasNext() && !monitor.isCancelled()) {
                Data d = it.next();
                if (!d.hasStringValue()) continue;
                Set<String> users = new TreeSet<>();
                for (Reference r : refs.getReferencesTo(d.getAddress())) users.add(fn(r.getFromAddress()));
                String v = String.valueOf(d.getValue()).replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
                w.printf("%s\t%s\t%s%n", d.getAddress(), String.join(" ", users), v);
            }
        }

        FunctionManager fm = currentProgram.getFunctionManager();
        try (PrintWriter w = new PrintWriter(new File(out, "functions.tsv"));
             PrintWriter cg = new PrintWriter(new File(out, "callgraph.tsv"))) {
            w.println("entry\tname\tsize\tcallers\tcallees\tthunk");
            cg.println("caller\tcallee");
            for (Function f : fm.getFunctions(true)) {
                Set<Function> callees = f.getCalledFunctions(monitor);
                Set<Function> callers = f.getCallingFunctions(monitor);
                w.printf("%s\t%s\t%d\t%d\t%d\t%s%n", f.getEntryPoint(), f.getName(), f.getBody().getNumAddresses(),
                        callers.size(), callees.size(), f.isThunk() ? "thunk" : "");
                for (Function c : callees) cg.printf("%s@%s\t%s@%s%n", f.getName(), f.getEntryPoint(), c.getName(), c.getEntryPoint());
            }
        }

        DecompInterface dec = new DecompInterface();
        dec.openProgram(currentProgram);
        int n = 0, failed = 0;
        try (PrintWriter w = new PrintWriter(new File(out, "decompiled.c"))) {
            for (Function f : fm.getFunctions(true)) {
                if (monitor.isCancelled()) break;
                if (f.isThunk() || f.isExternal()) continue;
                DecompileResults r = dec.decompileFunction(f, 60, monitor);
                w.printf("%n// ===== %s @ %s (size %d) =====%n", f.getName(), f.getEntryPoint(), f.getBody().getNumAddresses());
                if (r != null && r.decompileCompleted()) {
                    w.print(r.getDecompiledFunction().getC());
                } else {
                    failed++;
                    w.println("// decompile failed: " + (r == null ? "null" : r.getErrorMessage()));
                }
                n++;
            }
        }
        dec.dispose();
        println("ExportAll: decompiled " + n + " functions (" + failed + " failed) into " + out.getAbsolutePath());
    }
}
