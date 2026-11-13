/**
 * Logo de Vigie, version sans fond : un anneau clair (`ui-ink`) autour d'un point `ui-live`.
 * À poser seulement sur un panneau sombre (`ui-glass` ou plus) : l'anneau est clair. Ni recoloré, ni étiré.
 * Les encres sont celles du système de design (`design/logos/vigie-mark-nu.svg`) : #f1f4f9 et #ff453a.
 */
export function Mark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <circle cx="24" cy="24" r="17" fill="none" stroke="#f1f4f9" strokeWidth="4" />
      <circle cx="24" cy="24" r="6" fill="#ff453a" />
    </svg>
  );
}
