Pod::Spec.new do |s|
  s.name           = 'EmberlyTranslate'
  s.version        = '1.0.0'
  s.summary        = 'On-device Apple Translation for Emberly Maintenance work-order prose.'
  s.description    = 'Batches work-order titles, descriptions, and tech notes through Apple\'s on-device Translation framework (iOS 18+).'
  s.author         = 'Emberly'
  s.homepage       = 'https://emberly.krkn.app'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
