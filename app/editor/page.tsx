import { connection } from "next/server";
import EditorLoader from "@/components/EditorLoader";
import { storeEnabled } from "@/lib/store";

// Rendered per request (no static shell) so the CSP nonce from proxy.ts reaches every script.
export const instant = false;

export default async function EditorPage() {
  await connection();
  return (
    <EditorLoader
      canPublish={storeEnabled}
      canUpload={Boolean(process.env.BLOB_READ_WRITE_TOKEN)}
      contact={process.env.LINKMI_REPORT_EMAIL}
    />
  );
}
