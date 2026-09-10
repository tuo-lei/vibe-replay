import open from "open";

export async function publishLocal(outputPath: string): Promise<void> {
  await open(outputPath);
}

/** Open a local file in the browser; return false if the OS opener fails. */
export async function tryPublishLocal(outputPath: string): Promise<boolean> {
  try {
    await publishLocal(outputPath);
    return true;
  } catch {
    return false;
  }
}
