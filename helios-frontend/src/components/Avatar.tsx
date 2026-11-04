import Image from "next/image";

/** A portrait when there is one, else the initials on light blue. */
export function Avatar({
  name,
  photo,
  size,
}: {
  name: string;
  photo?: string;
  size: number;
}) {
  if (photo)
    return (
      <Image
        src={photo}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full bg-subtle object-cover"
        style={{ width: size, height: size }}
      />
    );
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
  return (
    <span
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-sky font-medium text-[#41526b]"
    >
      {initials}
    </span>
  );
}
