import React from "react";

export interface NextImageProps
  extends React.ImgHTMLAttributes<HTMLImageElement> {
  fill?: boolean;
}

export default function Image({ src, alt, ...rest }: NextImageProps) {
  const resolvedSrc = typeof src === "string" ? src : "";
  return <img src={resolvedSrc} alt={alt} {...rest} />;
}

