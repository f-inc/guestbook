"use client";
import { useState } from "react";

export function CompanyIcon({ website, linkedin, company }: { website: unknown; linkedin: unknown; company: string }) {
  const query = new URLSearchParams();
  if (typeof website === "string") query.set("website", website);
  if (typeof linkedin === "string") query.set("linkedin", linkedin);
  const src = `/api/campus/company-icon?${query}`;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return <span className="request-company-icon" aria-hidden="true">{failedSrc !== src && query.size ? <img src={src} alt="" width={32} height={32} onError={() => setFailedSrc(src)} /> : company.slice(0, 1).toUpperCase()}</span>;
}
