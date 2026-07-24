Pod::Spec.new do |s|
  s.name           = 'EmberlySpeech'
  s.version        = '1.0.0'
  s.summary        = 'On-device Apple speech recognition for Emberly Maintenance dictation.'
  s.description    = 'Streams partial and final transcripts from Apple\'s Speech framework, pinned to on-device recognition so audio never leaves the phone.'
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
