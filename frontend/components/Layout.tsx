import React from 'react'
import Navbar from './Navbar'

interface LayoutProps {
  children: React.ReactNode
  title?: string
}

export default function Layout({ children, title }: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {title && <h1 className="text-2xl font-bold text-gray-900 mb-6">{title}</h1>}
        {children}
      </main>
    </div>
  )
}
