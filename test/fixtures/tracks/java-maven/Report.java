import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/** Converts JUnit XML reports (Surefire's TEST-*.xml) in a folder into Codemm's report: {"tests":[{name,status,message?}]}. */
public class Report {
    public static void main(String[] args) throws Exception {
        StringBuilder out = new StringBuilder("{\"tests\":[");
        File[] files = new File(args[0]).listFiles((d, n) -> n.startsWith("TEST-") && n.endsWith(".xml"));
        boolean first = true;
        for (File f : files == null ? new File[0] : files) {
            NodeList cases = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(f).getElementsByTagName("testcase");
            for (int i = 0; i < cases.getLength(); i++) {
                Element c = (Element) cases.item(i);
                if (c.getElementsByTagName("skipped").getLength() > 0) continue;
                Element failure = (Element) c.getElementsByTagName("failure").item(0);
                Element error = (Element) c.getElementsByTagName("error").item(0);
                Element bad = failure != null ? failure : error;
                out.append(first ? "" : ",").append("{\"name\":").append(json(c.getAttribute("classname") + "." + c.getAttribute("name")));
                out.append(",\"status\":\"").append(failure != null ? "fail" : error != null ? "error" : "pass").append('"');
                if (bad != null) out.append(",\"message\":").append(json(bad.getAttribute("message")));
                out.append('}');
                first = false;
            }
        }
        Files.writeString(Path.of(args[1]), out.append("]}").toString());
    }

    static String json(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            if (ch == '"' || ch == '\\') b.append('\\').append(ch);
            else if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
            else b.append(ch);
        }
        return b.append('"').toString();
    }
}
