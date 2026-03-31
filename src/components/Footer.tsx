import Link from 'next/link'

export default function Footer() {
  return (
    <footer className="border-t mt-auto py-6 text-center text-sm text-muted-foreground">
      <p className="mb-2">Bleib auf dem Laufenden mit deinen Lieblings-Podcasts.</p>
      <div className="flex items-center justify-center gap-4">
        <span>© {new Date().getFullYear()} Castletter</span>
        <span>·</span>
        <Link href="/impressum" className="hover:text-foreground transition-colors">
          Impressum
        </Link>
        <span>·</span>
        <Link href="/datenschutz" className="hover:text-foreground transition-colors">
          Datenschutz
        </Link>
      </div>
    </footer>
  )
}
