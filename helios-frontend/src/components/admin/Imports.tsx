"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Database, UploadCloud } from "react-feather";
import { gw, RUNNING, type ImportSummary, type Version } from "@/lib/gateway";
import type { LonglistSummary } from "@/lib/longlists";
import { ImportModal } from "../ImportModal";
import {
  Button,
  Notice,
  Page,
  Section,
  StatusPill,
  formatWhen,
  inputClass,
  td,
  th,
} from "./ui";

/** Upload, the list of imports and the global version history. */
export function ImportsPanel() {
  const router = useRouter();
  const [imports, setImports] = useState<ImportSummary[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  // "corpus", "new" (a new list) or a list id; every import runs in the
  // import dialog.
  const [into, setInto] = useState("corpus");
  const [lists, setLists] = useState<LonglistSummary[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [i, v] = await Promise.all([
        gw<ImportSummary[]>("/imports"),
        gw<Version[]>("/versions"),
      ]);
      setImports(i);
      setVersions(v);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    gw<LonglistSummary[]>("/longlists").then(setLists, () => {});
    // Initial fetch, then keep running imports' status fresh.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  function upload(picked: File) {
    setFile(picked);
  }

  async function revert(id: number) {
    try {
      await gw(`/versions/${id}/revert`, { method: "POST" });
      setConfirmRevert(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Page
      title="Imports"
      actions={
        <Link
          href="/admin/master"
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13.5px] font-medium transition-colors hover:bg-subtle"
        >
          <Database size={14} strokeWidth={1.75} />
          Master data
        </Link>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}

      <Section title="Upload a spreadsheet">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) upload(file);
          }}
          className={`flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-8 text-center transition-colors ${dragging ? "border-sky-ink bg-sky-wash" : "border-line"}`}
        >
          <UploadCloud size={22} strokeWidth={1.5} className="text-muted" />
          <p className="mt-2 text-[14px]">
            Drop an Excel or CSV file here, or{" "}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="font-medium underline decoration-[#b5b5ba] underline-offset-[3px] hover:decoration-ink"
            >
              choose one
            </button>
          </p>
          <p className="mt-1 text-[12.5px] text-muted">
            .xlsx, .xlsm, .xls, .xlsb, .ods or .csv
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-4">
            <label className="flex items-center gap-2 text-[13px] text-muted">
              Into
              <select
                value={into}
                onChange={(e) => setInto(e.target.value)}
                className={`${inputClass} max-w-[260px]`}
              >
                <option value="corpus">Corpus</option>
                <option value="new">New longlist</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    Longlist: {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <input
            ref={inputRef}
            type="file"
            hidden
            accept=".xlsx,.xlsm,.xls,.xlsb,.ods,.csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload(file);
              e.target.value = "";
            }}
          />
        </div>
      </Section>

      <Section title="Imports" aside={`${imports.length} total`}>
        {imports.length === 0 ? (
          <p className="text-[13.5px] text-muted">No imports yet.</p>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-[13.5px]">
            <thead>
              <tr>
                <th className={th}>File</th>
                <th className={th}>Status</th>
                <th className={th}>Source</th>
                <th className={`${th} text-right`}>Rows</th>
                <th className={th}>Version</th>
                <th className={th}>By</th>
                <th className={th}>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((i) => (
                <tr
                  key={i.id}
                  onClick={() => router.push(`/admin/imports/${i.id}`)}
                  className="cursor-pointer transition-colors hover:bg-canvas"
                >
                  <td className={`${td} max-w-[280px] truncate font-medium`}>
                    {i.filename}
                  </td>
                  <td className={td}>
                    <StatusPill status={i.status} />
                    {RUNNING.includes(i.status) && (
                      <span className="ml-2 text-[12px] text-muted tabular-nums">
                        {Math.round(i.progress * 100)}%
                      </span>
                    )}
                  </td>
                  <td className={`${td} text-muted`}>
                    {i.target === "list"
                      ? "list import"
                      : i.source_type === "other" && i.source_note
                        ? `other: ${i.source_note}`
                        : i.source_type}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {i.rows ?? "–"}
                  </td>
                  <td className={`${td} tabular-nums`}>
                    {i.version_id ? `v${i.version_id}` : "–"}
                  </td>
                  <td className={`${td} text-muted`}>{i.created_by}</td>
                  <td className={`${td} text-muted`}>
                    {formatWhen(i.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section
        title="Version history"
        aside="Every import is one version. Reverting adds a new version; nothing is deleted."
      >
        {versions.length === 0 ? (
          <p className="text-[13.5px] text-muted">No versions yet.</p>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-[13.5px]">
            <thead>
              <tr>
                <th className={th}>Version</th>
                <th className={th}>Change</th>
                <th className={th}>By</th>
                <th className={th}>When</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td className={`${td} font-medium tabular-nums`}>v{v.id}</td>
                  <td className={td}>
                    {v.message}
                    <span className="ml-2 text-[12.5px] text-muted">
                      {Object.entries(v.counts)
                        .filter(([, n]) => n)
                        .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
                        .join(" · ")}
                    </span>
                    {v.reverted_by_version_id && (
                      <span className="ml-2 rounded-md bg-subtle px-1.5 py-0.5 text-[12px] text-muted">
                        reverted in v{v.reverted_by_version_id}
                      </span>
                    )}
                  </td>
                  <td className={`${td} text-muted`}>{v.author}</td>
                  <td className={`${td} text-muted`}>
                    {formatWhen(v.created_at)}
                  </td>
                  <td className={`${td} text-right`}>
                    {!v.reverted_by_version_id &&
                      (confirmRevert === v.id ? (
                        <span className="inline-flex gap-1">
                          <Button
                            variant="primary"
                            onClick={() => revert(v.id)}
                          >
                            {v.kind === "revert" ? "Re-apply" : "Revert"}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => setConfirmRevert(null)}
                          >
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() => setConfirmRevert(v.id)}
                        >
                          {v.kind === "revert"
                            ? `Re-apply v${v.reverts_version_id}`
                            : "Revert"}
                        </Button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      {file && (
        <ImportModal
          open
          file={file}
          target={
            into === "corpus"
              ? { kind: "corpus" }
              : { kind: "list", listId: into === "new" ? null : into }
          }
          onClose={() => {
            setFile(null);
            load();
          }}
        />
      )}
    </Page>
  );
}
