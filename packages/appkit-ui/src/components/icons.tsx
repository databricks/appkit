import React from "react";

export const Icons = {
  logo(props: React.SVGProps<SVGSVGElement>) {
    return (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M6 12h3" />
        <path d="M15 12h3" />
        <path d="M12 6v3" />
        <path d="M12 15v3" />
      </svg>
    );
  },
};

