import React from "react";

export interface NextLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href?: string;
  legacyBehavior?: boolean;
}

export default function Link({ children, href, ...rest }: NextLinkProps) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

