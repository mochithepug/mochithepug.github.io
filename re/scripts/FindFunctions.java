// Discover functions Ghidra's auto-analysis missed (reached only through pointers):
//  1. 4-byte values in non-code sections that point into .text where no function exists
//  2. 16-byte aligned starts after NOP/INT3 padding (MSVC function alignment) inside uncovered gaps
// Repeats until nothing new is found. Saves the program.
// Usage: re/scripts/headless.sh -process Tod_e.exe -scriptPath re/scripts -postScript FindFunctions.java
//@category TTOTD
import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.cmd.function.CreateFunctionCmd;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.mem.*;

public class FindFunctions extends GhidraScript {
    private MemoryBlock text;

    private boolean tryCreate(Address a) throws Exception {
        if (getFunctionContaining(a) != null) return false;
        Instruction ins = getInstructionAt(a);
        if (ins == null) {
            if (getDataAt(a) != null && getDataAt(a).isDefined()) return false;
            DisassembleCommand dc = new DisassembleCommand(a, null, true);
            if (!dc.applyTo(currentProgram, monitor) || getInstructionAt(a) == null) return false;
        }
        CreateFunctionCmd cf = new CreateFunctionCmd(a);
        return cf.applyTo(currentProgram, monitor) && getFunctionAt(a) != null;
    }

    private int fromPointers() throws Exception {
        int n = 0;
        Memory mem = currentProgram.getMemory();
        for (MemoryBlock b : mem.getBlocks()) {
            if (b.isExecute() || !b.isInitialized()) continue;
            Address end = b.getEnd();
            for (Address a = b.getStart(); a.compareTo(end.subtract(3)) <= 0; a = a.add(4)) {
                int v;
                try { v = mem.getInt(a); } catch (MemoryAccessException e) { continue; }
                long u = v & 0xffffffffL;
                if (u < text.getStart().getOffset() || u > text.getEnd().getOffset()) continue;
                Address t = toAddr(u);
                if (getFunctionContaining(t) != null) continue;
                // plausible start: previous byte is padding/ret, or address is 16-aligned
                byte prev = mem.getByte(t.subtract(1));
                if ((u & 0xf) != 0 && prev != (byte) 0x90 && prev != (byte) 0xcc && prev != (byte) 0xc3) continue;
                if (tryCreate(t)) n++;
            }
        }
        return n;
    }

    private int fromGaps() throws Exception {
        int n = 0;
        Memory mem = currentProgram.getMemory();
        Address a = text.getStart();
        while (a.compareTo(text.getEnd()) < 0 && !monitor.isCancelled()) {
            Function f = getFunctionContaining(a);
            if (f != null) { a = f.getBody().getMaxAddress().add(1); continue; }
            byte b = mem.getByte(a);
            if (b == (byte) 0x90 || b == (byte) 0xcc || b == 0) { a = a.add(1); continue; }
            if ((a.getOffset() & 0xf) == 0) {
                byte prev = mem.getByte(a.subtract(1));
                if ((prev == (byte) 0x90 || prev == (byte) 0xcc || prev == (byte) 0xc3) && tryCreate(a)) {
                    n++;
                    continue;
                }
            }
            a = a.add(1);
        }
        return n;
    }

    @Override
    protected void run() throws Exception {
        text = currentProgram.getMemory().getBlock(".text");
        int total = 0;
        for (int pass = 1; pass <= 6; pass++) {
            int p = fromPointers(), g = fromGaps();
            println("pass " + pass + ": " + p + " from pointers, " + g + " from gaps");
            total += p + g;
            if (p + g == 0) break;
        }
        long covered = 0;
        for (Function f : currentProgram.getFunctionManager().getFunctions(true))
            if (text.contains(f.getEntryPoint())) covered += f.getBody().getNumAddresses();
        println("FindFunctions: created " + total + "; .text coverage " + (100 * covered / text.getSize()) + "%");
    }
}
