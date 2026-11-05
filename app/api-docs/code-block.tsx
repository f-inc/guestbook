"use client";
import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./page.module.css";
function plainText(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child)
    ? plainText(child.props.children) : String(child)).join("");
}
export function CodeBlock({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try { await navigator.clipboard.writeText(plainText(children)); setStatus("Copied"); }
    catch { setStatus("Select the code to copy manually."); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(""), 3000);
  }
  return <div className={styles.codeBlock}>
    <div className={styles.codeTools}><span role="status">{status}</span><button type="button" onClick={copy} aria-label="Copy code">Copy</button></div>
    <pre>{children}</pre>
  </div>;
}
