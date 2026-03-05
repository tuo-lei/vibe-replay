import open from "open";

export async function publishLocal(outputPath: string): Promise<void> {
  await open(outputPath);
}
