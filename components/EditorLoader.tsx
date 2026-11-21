"use client";

import dynamic from "next/dynamic";

// The editor reads localStorage and the URL hash on first render, so it only runs in the browser.
const Editor = dynamic(() => import("./Editor"), { ssr: false });

export default function EditorLoader(props: { canPublish: boolean; canUpload: boolean; contact?: string }) {
  return <Editor {...props} />;
}
