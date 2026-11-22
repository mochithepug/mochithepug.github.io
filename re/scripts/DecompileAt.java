// Decompile functions at the given addresses, creating them first if Ghidra's analysis missed them
// (code reached only through pointers). Writes re/out/decomp_<addr>.c and saves the new functions.
// Usage: re/scripts/headless.sh -process Tod_e.exe -noanalysis -scriptPath re/scripts \
//          -postScript DecompileAt.java re/out 476a10 [more addresses...]
//@category TTOTD
import ghidra.app.cmd.function.CreateFunctionCmd;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import java.io.File;
import java.io.PrintWriter;

public class DecompileAt extends GhidraScript {
    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        File out = new File(args[0]);
        DecompInterface dec = new DecompInterface();
        dec.openProgram(currentProgram);
        for (int i = 1; i < args.length; i++) {
            Address a = toAddr(Long.parseLong(args[i], 16));
            Function f = getFunctionAt(a);
            if (f == null) {
                disassemble(a);
                new CreateFunctionCmd(a).applyTo(currentProgram, monitor);
                f = getFunctionAt(a);
                println("created function at " + a);
            }
            if (f == null) { println("could not create function at " + a); continue; }
            DecompileResults r = dec.decompileFunction(f, 120, monitor);
            try (PrintWriter w = new PrintWriter(new File(out, "decomp_" + args[i] + ".c"))) {
                w.println("// " + f.getName() + " @ " + f.getEntryPoint() + " (size " + f.getBody().getNumAddresses() + ")");
                w.print(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "// failed: " + r.getErrorMessage());
            }
        }
        dec.dispose();
    }
}
