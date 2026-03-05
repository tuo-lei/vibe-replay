interface Props {
  content: string;
  images?: string[];
  isActive: boolean;
}

export default function UserPromptBlock({ content, images, isActive }: Props) {
  return (
    <div>
      <div
        className={`text-terminal-green font-mono text-sm whitespace-pre-wrap break-words ${
          isActive ? "typing-cursor" : ""
        }`}
      >
        {content}
      </div>
      {images && images.length > 0 && (
        <div className="flex gap-2 mt-2 flex-wrap">
          {images.map((src, i) => (
            <img
              key={i}
              src={src}
              alt={`Attached image ${i + 1}`}
              className="max-w-[300px] max-h-[200px] rounded border border-terminal-border object-contain"
            />
          ))}
        </div>
      )}
    </div>
  );
}
