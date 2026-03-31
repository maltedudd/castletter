import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function Home() {
  return (
    <div className="flex flex-col flex-1">
      {/* Hero Section */}
      <div className="flex-1 flex items-center justify-center section-spacing">
        <div className="max-w-5xl mx-auto container-spacing text-center space-y-12">
          {/* Logo/Brand */}
          <div className="space-y-4">
            <h1 className="text-6xl md:text-7xl lg:text-8xl font-bold tracking-tight">
              Castletter
            </h1>
            <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mx-auto">
              Erhalte täglich personalisierte Newsletter zu deinen Lieblings-Podcasts
            </p>
          </div>

          {/* Features */}
          <div className="grid md:grid-cols-3 gap-8 py-12">
            <div className="space-y-3">
              <div className="text-4xl mb-4">🎧</div>
              <h3 className="text-lg font-semibold">Podcast-Abos</h3>
              <p className="text-muted-foreground">
                Abonniere deine Lieblings-Podcasts per RSS-Feed
              </p>
            </div>
            <div className="space-y-3">
              <div className="text-4xl mb-4">📝</div>
              <h3 className="text-lg font-semibold">KI-Zusammenfassungen</h3>
              <p className="text-muted-foreground">
                Automatisch generierte Zusammenfassungen neuer Episodes
              </p>
            </div>
            <div className="space-y-3">
              <div className="text-4xl mb-4">📧</div>
              <h3 className="text-lg font-semibold">Tägliche Newsletter</h3>
              <p className="text-muted-foreground">
                Erhalte alle Zusammenfassungen zu deiner Wunschzeit
              </p>
            </div>
          </div>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center pt-8">
            <Link href="/register">
              <Button size="lg" className="w-full sm:w-auto text-lg h-14 px-8">
                Jetzt starten
              </Button>
            </Link>
            <Link href="/login">
              <Button size="lg" variant="outline" className="w-full sm:w-auto text-lg h-14 px-8">
                Anmelden
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
