// Apply names from re/symbols.tsv (address<TAB>fn|data<TAB>name<TAB>note) to the program.
// Usage: re/scripts/headless.sh -process Tod_e.exe -noanalysis -scriptPath re/scripts \
//          -postScript ApplySymbols.java re/symbols.tsv
//@category TTOTD
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.CodeUnit;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.SourceType;
import java.nio.file.*;

public class ApplySymbols extends GhidraScript {
    @Override
    protected void run() throws Exception {
        int n = 0;
        for (String line : Files.readAllLines(Path.of(getScriptArgs()[0]))) {
            if (line.isBlank() || line.startsWith("#")) continue;
            String[] c = line.split("\t");
            if (c.length < 3) continue;
            Address a = toAddr(Long.parseLong(c[0], 16));
            if (c[1].equals("fn")) {
                Function f = getFunctionAt(a);
                if (f == null) f = createFunction(a, c[2]);
                else f.setName(c[2], SourceType.USER_DEFINED);
            } else {
                createLabel(a, c[2], true, SourceType.USER_DEFINED);
            }
            if (c.length > 3) currentProgram.getListing().setComment(a, CodeUnit.PLATE_COMMENT, c[3]);
            n++;
        }
        println("ApplySymbols: applied " + n + " symbols");
    }
}
