import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { getTranslations } from 'next-intl/server'

export default async function Home() {
  const t = await getTranslations('landing')

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
              {t('subtitle')}
            </p>
          </div>

          {/* Features */}
          <div className="grid md:grid-cols-3 gap-8 py-12">
            <div className="space-y-3">
              <div className="text-4xl mb-4">🎧</div>
              <h3 className="text-lg font-semibold">{t('feature1Title')}</h3>
              <p className="text-muted-foreground">
                {t('feature1Description')}
              </p>
            </div>
            <div className="space-y-3">
              <div className="text-4xl mb-4">📝</div>
              <h3 className="text-lg font-semibold">{t('feature2Title')}</h3>
              <p className="text-muted-foreground">
                {t('feature2Description')}
              </p>
            </div>
            <div className="space-y-3">
              <div className="text-4xl mb-4">📧</div>
              <h3 className="text-lg font-semibold">{t('feature3Title')}</h3>
              <p className="text-muted-foreground">
                {t('feature3Description')}
              </p>
            </div>
          </div>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center pt-8">
            <Link href="/register">
              <Button size="lg" className="w-full sm:w-auto text-lg h-14 px-8">
                {t('ctaStart')}
              </Button>
            </Link>
            <Link href="/login">
              <Button size="lg" variant="outline" className="w-full sm:w-auto text-lg h-14 px-8">
                {t('ctaLogin')}
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
