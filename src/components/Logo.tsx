import React from 'react';

interface LogoProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
  variant?: 'icon' | 'full';
  className?: string;
}

export function Logo({ size = 24, variant = 'icon', className = '', ...rest }: LogoProps) {
  if (variant === 'icon') {
    // Isometric 3D cube (Cloudflare orange + dark faces + clean borders).
    // Matches the cube in public/logo-mark.svg so the favicon and in-app icon
    // stay visually consistent.
    return (
      <svg
        width={size}
        height={size}
        viewBox="130 16 115 132"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
        {...rest}
      >
        <path d="M132.156 49.2277L187.5 81.013V145.699L132.156 113.356V49.2277Z" fill="#42474C" />
        <path d="M187.5 81.013L242.844 49.2277V113.356L187.5 145.699V81.013Z" fill="#353B41" />
        <path d="M187.5 18L242.844 49.2277L187.5 81.013L132.156 49.2277L187.5 18Z" fill="#F38020" />
        <path d="M132.156 49.2277V113.356L187.5 145.699L242.844 113.356V49.2277" stroke="#E8FCF7" strokeWidth="5" strokeLinejoin="round" />
        <path d="M187.5 18L242.844 49.2277L187.5 81.013L132.156 49.2277L187.5 18Z" stroke="#E8FCF7" strokeWidth="4" strokeLinejoin="round" />
      </svg>
    );
  }

  // Full logo (cube + brand typography). Sourced from public/logo-mark.svg
  // (the clean web variant without the outline mask).
  const height = Math.round(size * (262 / 375));
  return (
    <img
      src="/logo-mark.svg"
      alt="Markflare"
      width={size}
      height={height}
      className={className}
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
      {...(rest as React.ImgHTMLAttributes<HTMLImageElement>)}
    />
  );
}
